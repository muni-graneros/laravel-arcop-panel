@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Resolver la solicitud N.º '.$solicitud->getKey())

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <p><a href="{{ route('arcop.solicitudes.show', $solicitud) }}">&larr; Volver a la solicitud</a></p>

    <h1>Resolver la solicitud N.º {{ $solicitud->getKey() }}</h1>

    @if ($advertencia)
        <p class="arcop-aviso arcop-aviso--atencion" role="note">{{ $advertencia }}</p>
    @endif

    @if ($nota)
        <p class="arcop-guia">{{ $nota }}</p>
    @endif

    <form method="POST" action="{{ route('arcop.solicitudes.resolver.aplicar', $solicitud) }}" class="arcop-formulario">
        @csrf

        <fieldset class="arcop-campo">
            <legend>Cómo se resuelve</legend>
            @foreach ($resultados as $valor => $etiqueta)
                <label class="arcop-opcion">
                    <input type="radio" name="resultado" value="{{ $valor }}" @checked(old('resultado') === $valor) required>
                    {{ $etiqueta }}
                </label>
            @endforeach
        </fieldset>

        <div class="arcop-campo">
            <label for="fundamento">Fundamento de la resolución</label>
            <textarea id="fundamento" name="fundamento" rows="5" required
                      aria-describedby="fundamento-ayuda">{{ old('fundamento') }}</textarea>
            <p id="fundamento-ayuda" class="arcop-ayuda">Es lo que se le responde al titular. El módulo no
                resuelve sin fundamento.</p>
        </div>

        <button class="arcop-boton arcop-boton--principal" type="submit">Resolver</button>
    </form>
@endsection
